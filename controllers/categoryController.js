const Category = require('../models/Category');
const Product = require('../models/Product');

// @desc    Get all categories
// @route   GET /api/categories
// @access  Private
exports.getCategories = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const companyId = req.user.company._id;
    const query = { company: companyId };
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const categories = await Category.find(query)
      .populate('createdBy', 'name email')
      .sort({ name: 1 });

    res.json({
      success: true,
      count: categories.length,
      data: categories
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Private
exports.getCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const category = await Category.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Get products count in this category
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    res.json({
      success: true,
      data: {
        ...category.toObject(),
        productsCount
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new category
// @route   POST /api/categories
// @access  Private (admin, stock_manager)
exports.createCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    req.body.company = companyId;
    req.body.createdBy = req.user.id;

    const category = await Category.create(req.body);

    res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private (admin, stock_manager)
exports.updateCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private (admin)
exports.deleteCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if category has products
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. It has ${productsCount} product(s) associated with it.`
      });
    }

    const category = await Category.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
